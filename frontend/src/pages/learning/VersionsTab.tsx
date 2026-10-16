import type { TFunction } from 'i18next';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { errorMessage } from '../../api/errors';
import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, DataTable, Icon, Skeleton, useToast } from '../../components';
import { useStrategy } from '../../features/analysis/api';
import type { Comparison, EvalRun, EvalSet, LearningSummary, StrategyVersion } from '../../features/learning/types';
import {
  ci3,
  ciNum3,
  compareRows,
  eceDiff,
  type CompareKey,
  dec3,
  findActive,
  findCandidate,
  newestFirst,
  signed3,
  tokensText,
  versionShort,
} from '../../features/learning/versionView';
import { ruleCode, rulesCodes, RULES_FIRST_CODE } from '../../features/learning/versionList';
import { activeEvalRun, useCancelEval, useEvalRuns, useFreezeSet, useStrategyVersions } from '../../features/learning/versions';
import { formatDate, formatNumber, formatUsd } from '../../lib/format';
import { EvalModal } from './EvalModal';
import { CompareModal, VersionChip, VersionModal } from './VersionModals';

// Вкладка «Версии стратегии» (versionsPanel макета): инструкции анализа — общая линия версий,
// ее ведет администратор (В5): таблица с лог-лоссом на замороженном наборе и разницей с рынком
// архива (ДИ), сравнение кандидата с активной, прогон на наборе с кодом 2FA и «Остановить»,
// включение и откат. Правила приема; свои правила суммы ставки — версиями (кабинет).

function LogLossCell({ version }: { version: StrategyVersion }) {
  const { t } = useTranslation();
  const ev = version.eval;
  if (!ev || ev.log_loss === null) return <span className="muted">{t('learning.versions.notRun')}</span>;
  return (
    <span>
      {dec3(ev.log_loss)}
      <span className="xsmall muted"> · {t('learning.versions.runs', { count: ev.runs })}</span>
    </span>
  );
}

function MarketCell({ version }: { version: StrategyVersion }) {
  const { t } = useTranslation();
  const market = version.eval?.to_market ?? null;
  if (!market) return <span className="muted">—</span>;
  return (
    <div>
      <div>{signed3(market.value)}</div>
      <div className="xsmall muted learning-nowrap">{t('learning.versions.ci', { ci: ciNum3(market) })}</div>
    </div>
  );
}

function VersionCard({ version }: { version: StrategyVersion }) {
  const { t } = useTranslation();
  const ev = version.eval;
  return (
    <div className="learning-vcard">
      <div className="learning-vcard-head">
        <div className="learning-min">
          <div className="learning-ver-name">
            <b>{version.code}</b>
            <span className="xsmall muted">{formatDate(version.created_at)}</span>
          </div>
          <div className="small soft">{versionShort(version)}</div>
        </div>
        <VersionChip status={version.status} />
      </div>
      {ev && ev.log_loss !== null && (
        <dl className="learning-vgrid">
          <div>
            <dt>{t('learning.versions.cols.logLoss')}</dt>
            <dd>{dec3(ev.log_loss)}</dd>
          </div>
          <div>
            <dt>{t('learning.versions.cols.marketShort')}</dt>
            <dd>{ev.to_market ? signed3(ev.to_market.value) : '—'}</dd>
          </div>
          <div>
            <dt>{t('learning.versions.cols.brier')}</dt>
            <dd>{dec3(ev.brier)}</dd>
          </div>
          <div>
            <dt>{t('learning.versions.cols.tokensShort')}</dt>
            <dd>{tokensText(ev.tokens_per_event, t)}</dd>
          </div>
        </dl>
      )}
    </div>
  );
}

function VersionsTable({ versions, onOpen }: { versions: StrategyVersion[]; onOpen: (version: StrategyVersion) => void }) {
  const { t } = useTranslation();
  return (
    <DataTable
      className="learning-vtable"
      caption={t('learning.versions.title')}
      rows={versions}
      rowKey={(version) => version.id}
      onRowClick={onOpen}
      renderCard={(version) => <VersionCard version={version} />}
      columns={[
        {
          key: 'version',
          label: t('learning.versions.cols.version'),
          primary: true,
          render: (version) => (
            <div className="learning-ver-name">
              <b>{version.code}</b>
              <span className="soft">{versionShort(version)}</span>
            </div>
          ),
        },
        { key: 'date', label: t('learning.versions.cols.date'), render: (version) => formatDate(version.created_at) },
        { key: 'logLoss', label: t('learning.versions.cols.logLoss'), align: 'r', render: (version) => <LogLossCell version={version} /> },
        { key: 'market', label: t('learning.versions.cols.market'), align: 'r', render: (version) => <MarketCell version={version} /> },
        { key: 'brier', label: t('learning.versions.cols.brier'), align: 'r', render: (version) => (version.eval?.brier != null ? dec3(version.eval.brier) : '—') },
        { key: 'tokens', label: t('learning.versions.cols.tokens'), align: 'r', render: (version) => tokensText(version.eval?.tokens_per_event, t) },
        { key: 'status', label: t('learning.versions.cols.status'), render: (version) => <VersionChip status={version.status} /> },
      ]}
    />
  );
}

/** Набор еще не заморожен: администратору — «Заморозить набор» (денег не тратит). */
function NotFrozen({ admin, onFrozen }: { admin: boolean; onFrozen: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const freeze = useFreezeSet();
  const [error, setError] = useState<string | null>(null);
  function run() {
    setError(null);
    freeze.mutate(undefined, {
      onSuccess: (set) => {
        onFrozen();
        toast.show(t('learning.versions.frozen', { code: set.code, matches: t('learning.plural.matches', { count: set.n_events, n: formatNumber(set.n_events) }) }), {
          icon: 'lock',
          duration: 5000,
        });
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  }
  return (
    <>
      <Callout kind="warn" icon="database">
        <b>{t('learning.versions.notFrozen')}</b>
        {t('learning.versions.notFrozenText')} {admin ? t('learning.versions.notFrozenAdmin') : t('learning.versions.notFrozenMember')}
      </Callout>
      {admin && (
        <Button kind="secondary" size="sm" icon="lock" loading={freeze.isPending} onClick={run}>
          {t('learning.versions.freeze')}
        </Button>
      )}
      {error && (
        <Callout kind="bad" icon="alert" role="alert">
          {error}
        </Callout>
      )}
    </>
  );
}

/** Идет прогон версии на наборе: ход и «Остановить» (администратор). */
function RunBanner({ run, onOpen }: { run: EvalRun; onOpen: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const cancel = useCancelEval();
  const canceling = run.waiting === 'eval.canceling';
  return (
    <Callout kind="info" icon="clock" role="status">
      <span>
        <b>{t('learning.eval.bannerTitle', { code: run.version_code ?? '—', set: run.eval_set_code })} </b>
        {t('learning.eval.bannerText', { done: run.chunks_done, total: run.chunks_total, cost: formatUsd(run.cost_usd) })}
        {canceling && ` ${t('learning.eval.canceling')}`}
      </span>
      <span className="learning-banner-actions">
        <Button kind="ghost" size="sm" iconRight="chevronRight" onClick={onOpen}>
          {t('learning.eval.progress')}
        </Button>
        {!canceling && (
          <Button
            kind="secondary"
            size="sm"
            icon="pause"
            loading={cancel.isPending}
            onClick={() =>
              cancel.mutate(run.id, {
                onSuccess: () => toast.show(t('learning.eval.stopped', { code: run.version_code ?? '' }), { icon: 'pause' }),
                onError: (failure) => toast.show(errorMessage(failure), { icon: 'alert' }),
              })
            }
          >
            {t('learning.eval.stop')}
          </Button>
        )}
      </span>
    </Callout>
  );
}

function setSubtitle(set: EvalSet, t: TFunction): string {
  return t('learning.versions.subtitleSet', {
    code: set.code,
    matches: t('learning.plural.matches', { count: set.n_events, n: formatNumber(set.n_events) }),
    since: formatDate(set.since),
    hard: formatNumber(set.hard),
    sha: (set.sha256 ?? '').slice(0, 12),
  });
}

// пара сравнения запоминается при открытии: если версии сменят статус (отказ 409, решение
// другого администратора), окно остается открытым с текстом сервера
type Dialog =
  | { kind: 'version'; version: StrategyVersion }
  | { kind: 'compare'; a: StrategyVersion; b: StrategyVersion }
  | { kind: 'eval'; runId: number | null }
  | null;

function InstructionsCard({ summary, admin }: { summary: LearningSummary | null; admin: boolean }) {
  const { t } = useTranslation();
  const query = useStrategyVersions();
  const runs = useEvalRuns({ enabled: admin });
  const [dialog, setDialog] = useState<Dialog>(null);
  const evaluateRef = useRef<HTMLButtonElement>(null);
  // «Заморозить набор» исчезает после успеха: фокус — на «Оценить на наборе», как только
  // список версий перечитан и кнопка стала доступной
  const [focusEvaluate, setFocusEvaluate] = useState(false);
  const list = newestFirst(query.data?.instructions ?? []);
  const set = query.data ? query.data.eval_set : (summary?.eval_set ?? null);
  const active = findActive(list);
  const candidate = findCandidate(list);
  const running = admin ? activeEvalRun(runs.data) : null;
  const pair = active && candidate ? { a: active.code, b: candidate.code } : null;
  const fresh = (version: StrategyVersion) => list.find((item) => item.id === version.id) ?? version;

  let subtitle: string;
  if (set) subtitle = setSubtitle(set, t);
  else if (list.length === 1 && active) subtitle = t('learning.versions.subtitleOne', { version: active.code });
  else if (!query.data && summary) subtitle = t('learning.versions.subtitleOne', { version: summary.versions.active.code });
  else subtitle = t('learning.versions.subtitle');

  const compareButton = pair && (
    <Button kind={admin ? 'primary' : 'secondary'} size="sm" icon="layers" onClick={() => active && candidate && setDialog({ kind: 'compare', a: active, b: candidate })}>
      {t('learning.versions.compare', pair)}
    </Button>
  );
  const actions = admin ? (
    <>
      {compareButton}
      <Button ref={evaluateRef} kind="secondary" size="sm" icon="play" disabled={!set || !query.data} onClick={() => setDialog({ kind: 'eval', runId: running?.id ?? null })}>
        {t('learning.versions.evaluate')}
      </Button>
    </>
  ) : (
    <>
      <Chip kind="outline" icon="admin">
        {t('learning.byAdmin')}
      </Chip>
      {compareButton}
    </>
  );

  let body;
  if (query.isPending) body = <Skeleton lines={4} />;
  else if (!query.data) {
    body = (
      <p className="small muted" role="alert">
        {errorMessage(query.error)}{' '}
        <Button kind="ghost" size="sm" icon="refresh" onClick={() => void query.refetch()}>
          {t('common.retry')}
        </Button>
      </p>
    );
  } else {
    // одна версия и набора нет — как пустое состояние макета: сравнивать не с чем
    const showTable = Boolean(set) || list.length > 1;
    body = (
      <>
        {running && <RunBanner run={running} onOpen={() => setDialog({ kind: 'eval', runId: running.id })} />}
        {!set && <NotFrozen admin={admin} onFrozen={() => setFocusEvaluate(true)} />}
        {showTable && <VersionsTable versions={list} onOpen={(version) => setDialog({ kind: 'version', version })} />}
      </>
    );
  }
  const evaluateReady = Boolean(set && query.data);
  useEffect(() => {
    if (!focusEvaluate || !evaluateReady) return;
    evaluateRef.current?.focus();
    setFocusEvaluate(false);
  }, [focusEvaluate, evaluateReady]);

  const marketLl = set?.market_log_loss ?? null;
  const noise = active?.eval?.noise ?? null;
  const foot =
    set && query.data ? (
      <p className="learning-hint">
        <Icon name="info" />
        <span>
          {marketLl !== null ? t('learning.versions.footMarket', { ll: dec3(marketLl) }) : t('learning.versions.footMarketNone')}{' '}
          {noise !== null && active ? t('learning.versions.footNoise', { code: active.code, noise: dec3(noise) }) : t('learning.versions.footNoiseNone')}{' '}
          {t('learning.versions.footRoi', { matches: t('learning.plural.byMatches', { count: set.n_events, n: formatNumber(set.n_events) }) })}
        </span>
      </p>
    ) : undefined;

  return (
    <>
      <Card className="learning-card" title={t('learning.versions.title')} subtitle={subtitle} actions={actions} foot={foot}>
        {body}
      </Card>
      {dialog?.kind === 'version' && (
        <VersionModal
          version={list.find((item) => item.id === dialog.version.id) ?? dialog.version}
          active={active}
          set={set}
          admin={admin}
          onCompare={() => active && setDialog({ kind: 'compare', a: active, b: dialog.version })}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'compare' && <CompareModal a={fresh(dialog.a)} b={fresh(dialog.b)} admin={admin} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'eval' && query.data && (
        <EvalModal versions={list} runId={dialog.runId} onClose={() => setDialog(null)} />
      )}
    </>
  );
}

/** Чип правила приема по строке сравнения: «Лог-лосс: до +0,008», «Ошибок формата: 0». */
function ruleChipText(key: CompareKey, c: Comparison, diff: string, t: TFunction): string {
  switch (key) {
    case 'log_loss':
      return c.rule === 'improve'
        ? t('learning.versions.rules.chip.logLossCi', { ci: ci3(c.log_loss.low, c.log_loss.high) })
        : t('learning.versions.rules.chip.logLoss', { high: signed3(c.log_loss.high) });
    case 'brier':
      return t('learning.versions.rules.chip.brier', { high: signed3(c.brier.high) });
    case 'ece':
      return t('learning.versions.rules.chip.ece', { high: eceDiff(c.ece.high) });
    case 'format_errors':
      return t('learning.versions.rules.chip.format', { n: formatNumber(c.format_errors.b) });
    default:
      return t('learning.versions.rules.chip.tokens', { diff });
  }
}

function RulesCard({ instructions }: { instructions: StrategyVersion[] }) {
  const { t } = useTranslation();
  const active = findActive(instructions);
  const candidate = findCandidate(instructions);
  const comparison = candidate?.comparison ?? null;
  const rule = comparison?.rule ?? null;
  const item = (n: number, text: string, title?: string, status?: ReactNode) => (
    <li>
      <span aria-hidden="true">{n}</span>
      <div>
        {title && <b>{title}</b>}
        <span>{text}</span>
        {status}
      </div>
    </li>
  );
  let done = null;
  if (candidate && comparison && active) {
    done = (
      <Chip kind="good" icon="check">
        {t('learning.versions.rules.done', { a: active.code, an: active.eval?.runs ?? 0, b: candidate.code, bn: candidate.eval?.runs ?? 0 })}
      </Chip>
    );
  }
  const chips = comparison
    ? compareRows(comparison, t)
        .filter((row) => row.ok !== null)
        .map((row) => (
          <Chip key={row.key} kind={row.ok ? 'good' : 'bad'} icon={row.ok ? 'check' : 'x'}>
            {ruleChipText(row.key, comparison, row.diff, t)}
          </Chip>
        ))
    : null;
  const notFor = candidate && <Chip kind="outline" icon="info">{t('learning.versions.rules.notFor', { code: candidate.code })}</Chip>;
  const chipBox = (list: ReactNode) => <div className="learning-chips">{list}</div>;
  return (
    <Card
      className="learning-card"
      title={t('learning.versions.rules.title')}
      subtitle={candidate && rule ? t(`learning.versions.rules.subtitle_${rule}`, { code: candidate.code }) : t('learning.versions.rules.subtitle')}
    >
      <ol className="learning-rules">
        {item(1, t('learning.versions.rules.r1'), undefined, done)}
        {item(2, t('learning.versions.rules.r2'), t('learning.versions.rules.r2Title'), rule === 'improve' ? chipBox(chips) : rule ? notFor : null)}
        {item(3, t('learning.versions.rules.r3'), t('learning.versions.rules.r3Title'), rule === 'non_inferior' ? chipBox(chips) : rule ? notFor : null)}
        {item(4, t('learning.versions.rules.r4'))}
      </ol>
    </Card>
  );
}

/** Свои правила суммы ставки: версии участника (кандидат → проверка на своих ставках → включить). */
function StakeRulesCard({ rules }: { rules: StrategyVersion[] | null }) {
  const { t } = useTranslation();
  const strategy = useStrategy();
  const bankLink = { pathname: paths.profile('bank'), hash: '#profile-strategy' };
  let body;
  if (rules && rules.length) {
    const codes = rulesCodes(rules);
    body = (
      <div className="learning-rows">
        {newestFirst(rules).map((version) => (
          <div key={version.id} className="learning-row">
            <div className="learning-min">
              <div className="learning-ver-name">
                <b>{ruleCode(codes, version)}</b>
                <span className="soft small">{versionShort(version)}</span>
              </div>
              <div className="xsmall muted">{[formatDate(version.created_at), version.changes.join('; ')].filter(Boolean).join(' · ')}</div>
            </div>
            <div className="learning-row-side">
              <VersionChip status={version.status} />
              {version.status === 'candidate' && (
                <Button kind="primary" size="sm" icon="check" to={bankLink} title={t('learning.versions.stake.enableTitle')}>
                  {t('learning.versions.stake.enable')}
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>
    );
  } else if (strategy.isPending || rules === null) body = <Skeleton height={40} />;
  else if (!strategy.data) body = <p className="small muted">{t('learning.versions.stake.failed')}</p>;
  else
    body = (
      <div className="learning-row">
        <div className="learning-ver-name learning-min">
          {/* своих версий правил еще нет: действуют исходные — r1 */}
          <b>{RULES_FIRST_CODE}</b>
          <span className="soft small">{versionShort(strategy.data)}</span>
        </div>
        <VersionChip status="active" />
      </div>
    );
  return (
    <Card
      className="learning-card"
      title={t('learning.versions.stake.title')}
      subtitle={t('learning.versions.stake.subtitle')}
      actions={
        <Button kind="secondary" size="sm" icon="edit" to={bankLink}>
          {t('learning.versions.stake.propose')}
        </Button>
      }
    >
      {body}
    </Card>
  );
}

export function VersionsTab({ summary, admin }: { summary: LearningSummary | null; admin: boolean }) {
  const versions = useStrategyVersions();
  return (
    <div className="learning-panel">
      <InstructionsCard summary={summary} admin={admin} />
      <div className="learning-two wide-left">
        <RulesCard instructions={versions.data?.instructions ?? []} />
        <StakeRulesCard rules={versions.data ? versions.data.rules : versions.isError ? [] : null} />
      </div>
    </div>
  );
}
