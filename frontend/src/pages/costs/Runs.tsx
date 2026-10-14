import type { TFunction } from 'i18next';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, DataTable, EmptyState, Icon, KeyValue, Modal, Segmented, Skeleton, type DataColumn } from '../../components';
import { ChartLegend } from '../../components/charts';
import { apiErrorText } from '../../features/analysis/codes';
import { analysisNumber } from '../../features/analysis/number';
import { aiErrorText } from '../../features/ai/reasons';
import { modelLabel } from '../../features/ai/models';
import type { AiBudget } from '../../features/ai/types';
import { useAiRuns } from '../../features/costs/api';
import { cacheShareText, effortWord, isKnownKind, kindLabel, priceFormula, priceParts, unitPrice, usdRun, type PricePart } from '../../features/costs/display';
import type { AiRun, AiUsage, ModelPrice, RunFilter } from '../../features/costs/types';
import { usdLimit } from '../../features/dashboard/display';
import { formatDateTime, formatDuration, formatNumber, formatTokens, formatUsd } from '../../lib/format';
import { cx } from '../../lib/cx';
import { Howto } from './Blocks';

// «Журнал вызовов» (runsCard макета, Т17): строка — вызов Claude (agent_runs) с видом, номером
// вызова в анализе, моделью и effort, токенами, кэшем, поисками и ценой; нажатие — окно разбора
// цены (runModal). Страницы с сервера (GET /api/ai/runs, курсор).

type Filter = RunFilter | 'all';

function TaskCell({ run }: { run: AiRun }) {
  const { t } = useTranslation();
  return (
    <span className="costs-task">
      {kindLabel(run.kind, t)}
      {run.acceptance && (
        <Chip kind="info" icon="flask">
          {t('costs.runs.acceptance')}
        </Chip>
      )}
      {run.error && (
        <Chip kind="bad" icon="x">
          {t('costs.runs.error')}
        </Chip>
      )}
    </span>
  );
}

/** «вызов 3 анализа» — номер вызова внутри анализа (agent_runs.step). */
function stepText(run: AiRun, t: TFunction): string {
  return run.step > 0 && run.analysis_id !== null ? t('costs.runs.step', { n: run.step }) : '';
}

function cacheNote(run: AiRun, t: TFunction): string {
  if (run.error) return '—';
  if (run.cache_read_tokens > 0) return t('costs.runs.cached', { pct: cacheShareText(run.cache_share) ?? '—' });
  return run.cache_write_tokens > 0 ? t('costs.runs.writes') : t('costs.runs.noCache');
}

function AnalysisLink({ id, onClick }: { id: number; onClick?: () => void }) {
  const { t } = useTranslation();
  return (
    <Link className="costs-alink" to={paths.analysis(id)} onClick={(event) => { event.stopPropagation(); onClick?.(); }}>
      {t('costs.runs.analysisNo', { id: analysisNumber(id) })}
    </Link>
  );
}

function columns(t: TFunction): DataColumn<AiRun>[] {
  return [
    { key: 'when', label: t('costs.runs.cols.when'), render: (run) => <span className="costs-nowrap">{formatDateTime(run.created_at)}</span> },
    {
      key: 'call',
      label: t('costs.runs.cols.call'),
      primary: true,
      render: (run) => (
        <>
          <TaskCell run={run} />
          {stepText(run, t) && <div className="costs-sub costs-wrap">{stepText(run, t)}</div>}
        </>
      ),
    },
    { key: 'analysis', label: t('costs.runs.cols.analysis'), render: (run) => (run.analysis_id !== null ? <AnalysisLink id={run.analysis_id} /> : <span className="muted">—</span>) },
    {
      key: 'model',
      label: t('costs.runs.cols.model'),
      render: (run) => (
        <>
          <div>{modelLabel(run.model)}</div>
          <div className="costs-sub">{run.effort ? t('costs.effortChip', { effort: run.effort }) : '—'}</div>
        </>
      ),
    },
    {
      key: 'input',
      label: t('costs.runs.cols.input'),
      align: 'r',
      render: (run) => (
        <>
          <div>{formatTokens(run.prompt_tokens, { compact: true })}</div>
          <div className="costs-sub">{cacheNote(run, t)}</div>
        </>
      ),
    },
    { key: 'output', label: t('costs.runs.cols.output'), align: 'r', hideMobile: true, render: (run) => formatTokens(run.output_tokens, { compact: true }) },
    { key: 'searches', label: t('costs.runs.cols.searches'), align: 'r', hideMobile: true, render: (run) => (run.web_searches ? formatNumber(run.web_searches) : <span className="muted">—</span>) },
    { key: 'cost', label: t('costs.runs.cols.cost'), align: 'r', render: (run) => <b>{usdRun(run.cost_usd)}</b> },
    { key: 'open', label: t('costs.runs.cols.open'), hideLabel: true, render: () => <Icon name="chevronRight" className="costs-chev" /> },
  ];
}

function RunItem({ run, onOpen }: { run: AiRun; onOpen: () => void }) {
  const { t } = useTranslation();
  const meta = [formatDateTime(run.created_at), run.analysis_id !== null ? t('costs.runs.analysisNo', { id: analysisNumber(run.analysis_id) }) : null, `${modelLabel(run.model)}${run.effort ? `, ${t('costs.effortChip', { effort: run.effort })}` : ''}`]
    .filter(Boolean)
    .join(' · ');
  const tokens = run.error
    ? aiErrorText(run.error)
    : [
        t('costs.runs.inputShort', { tokens: formatTokens(run.prompt_tokens, { compact: true }) }) + (run.cache_read_tokens > 0 ? ` (${t('costs.runs.cacheShort', { pct: cacheShareText(run.cache_share) ?? '—' })})` : ''),
        t('costs.runs.outputShort', { tokens: formatTokens(run.output_tokens, { compact: true }) }),
        run.web_searches ? t('costs.searches', { count: run.web_searches }) : null,
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <li>
      <button type="button" className="costs-run" onClick={onOpen}>
        <span className="costs-run-main">
          <TaskCell run={run} />
          <span className="costs-run-meta">{meta}</span>
          {stepText(run, t) && <span className="costs-run-meta">{stepText(run, t)}</span>}
          <span className="costs-run-meta">{tokens}</span>
        </span>
        <span className="costs-run-cost">
          {usdRun(run.cost_usd)}
          <small>{t('costs.runs.more')}</small>
        </span>
      </button>
    </li>
  );
}

/** Кто платит за вызов: общая задача, свой ключ, ключ администратора (в лимит участника или бюджет). */
function payer(run: AiRun, budget: AiBudget, admin: boolean, t: TFunction): string {
  if (run.shared) return t('costs.run.payShared');
  if (run.key_source === 'own') return t('costs.run.payOwn');
  if (admin) return t('costs.run.payAdmin');
  if (budget.mode === 'own') return t('costs.run.payBefore');
  return budget.monthly_usd !== null ? t('costs.run.payLimit', { amount: usdLimit(budget.monthly_usd) }) : t('costs.run.payAdminKey');
}

const PART_KEYS = {
  cache_read: 'costs.run.parts.cacheRead',
  cache_write_5m: 'costs.run.parts.cacheWrite5m',
  cache_write_1h: 'costs.run.parts.cacheWrite1h',
  input: 'costs.run.parts.input',
  output: 'costs.run.parts.output',
  searches: 'costs.run.parts.searches',
} as const;

/** «12 345 ток.» или «2 поиска» — объем части цены. */
function partVolume(item: PricePart, t: TFunction): string {
  return item.key === 'searches' ? t('costs.searches', { count: item.part.tokens }) : t('costs.run.tokens', { n: formatNumber(item.part.tokens) });
}

/** «$3 / 1M» или «$0,01 за поиск» — цена единицы. */
function partPrice(item: PricePart, t: TFunction): string {
  return item.key === 'searches' ? t('costs.run.perSearch', { price: unitPrice(item.part.price) }) : t('costs.run.perMillion', { price: unitPrice(item.part.price) });
}

/** Части цены: на компьютере — таблица, на телефоне — список (mlist макета), чтобы «Сумма» не уходила за край окна. */
function PartsList({ parts, mobile }: { parts: PricePart[]; mobile: boolean }) {
  const { t } = useTranslation();
  if (mobile) {
    return (
      <ul className="costs-mlist" aria-label={t('costs.run.partsCaption')}>
        {parts.map((item) => (
          <li key={item.key}>
            <span className="t">{t(PART_KEYS[item.key])}</span>
            <span className="s">{t('costs.run.partSub', { volume: partVolume(item, t), price: partPrice(item, t) })}</span>
            <span className="v">{formatUsd(item.part.cost_usd, 4)}</span>
          </li>
        ))}
      </ul>
    );
  }
  return (
    <DataTable
      mobileLayout="table"
      className="costs-tablebox"
      caption={t('costs.run.partsCaption')}
      rows={parts}
      rowKey={(item) => item.key}
      columns={[
        { key: 'name', label: t('costs.run.cols.name'), render: (item) => t(PART_KEYS[item.key]) },
        { key: 'volume', label: t('costs.run.cols.volume'), align: 'r', render: (item) => partVolume(item, t) },
        { key: 'price', label: t('costs.run.cols.price'), align: 'r', render: (item) => partPrice(item, t) },
        { key: 'cost', label: t('costs.run.cols.cost'), align: 'r', render: (item) => <b>{formatUsd(item.part.cost_usd, 4)}</b> },
      ]}
    />
  );
}

/** Окно «разбор цены вызова» (runModal макета): из чего сложилась цена, формула и кто платит. */
export function RunModal({ run, budget, admin, mobile, onClose }: { run: AiRun; budget: AiBudget; admin: boolean; mobile: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const price = run.price;
  const parts = price ? priceParts(price) : [];
  const shown = parts.filter((item) => item.part.cost_usd > 0);
  const total = shown.reduce((sum, item) => sum + item.part.cost_usd, 0);
  const effort = effortWord(run.effort, t);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={t('costs.run.title', { kind: kindLabel(run.kind, t), when: formatDateTime(run.created_at) })}
      footer={
        <>
          <Button onClick={onClose}>{t('common.close')}</Button>
          {run.analysis_id !== null && (
            <Button kind="primary" iconRight="arrowRight" to={paths.analysis(run.analysis_id)} onClick={onClose}>
              {t('costs.run.toAnalysis', { id: analysisNumber(run.analysis_id) })}
            </Button>
          )}
        </>
      }
    >
      <div className="costs-modal-chips">
        <Chip kind="outline">{modelLabel(run.model)}</Chip>
        {run.effort && <Chip kind="outline">{t('costs.effortChip', { effort: run.effort })}</Chip>}
        {run.duration_ms !== null && (
          <Chip icon="clock">{formatDuration(run.duration_ms)}</Chip>
        )}
        {run.error ? (
          <Chip kind="bad" icon="x">
            {t('costs.runs.error')}
          </Chip>
        ) : run.cache_read_tokens > 0 ? (
          <Chip kind="good" icon="database">
            {t('costs.run.cacheChip', { pct: cacheShareText(run.cache_share) ?? '—' })}
          </Chip>
        ) : (
          <Chip icon="database">{t('costs.run.noCacheChip')}</Chip>
        )}
        {run.acceptance && (
          <Chip kind="info" icon="flask">
            {t('costs.runs.acceptance')}
          </Chip>
        )}
        {run.batch && <Chip kind="outline">{t('costs.run.batch')}</Chip>}
      </div>
      {run.error && (
        <Callout kind="bad" icon="alert">
          <b>{t('costs.run.failedStrong')}</b>
          {t('costs.run.failed', { reason: aiErrorText(run.error) })}
        </Callout>
      )}
      <div>
        <div className="eyebrow">{t('costs.run.price')}</div>
        <div className="stat-value">{usdRun(run.cost_usd)}</div>
      </div>
      {price && total > 0 ? (
        <>
          <div className="stack costs-gap8">
            <div className="costs-split" role="img" aria-label={t('costs.run.splitLabel', { list: shown.map((item) => `${t(PART_KEYS[item.key])} ${formatUsd(item.part.cost_usd, 4)}`).join(', ') })}>
              {shown.map((item) => (
                <i key={item.key} style={{ width: `${(item.part.cost_usd / total) * 100}%`, background: item.color }} title={`${t(PART_KEYS[item.key])}: ${formatUsd(item.part.cost_usd, 4)}`} />
              ))}
            </div>
            <ChartLegend items={shown.map((item) => ({ key: item.key, name: t(PART_KEYS[item.key]), color: item.color, type: 'box' }))} />
          </div>
          <PartsList parts={parts} mobile={mobile} />
          <div className="stack costs-gap6">
            <div className="eyebrow">{t('costs.run.formula')}</div>
            <div className="costs-formula">{priceFormula(run, price, t)}</div>
          </div>
        </>
      ) : !price ? (
        <p className="small muted">{t('costs.run.noPrice')}</p>
      ) : null}
      <KeyValue
        className="costs-detail"
        items={[
          { key: 'payer', label: t('costs.run.payer'), value: payer(run, budget, admin, t) },
          {
            key: 'analysis',
            label: t('costs.run.analysis'),
            value: run.analysis_id !== null ? <AnalysisLink id={run.analysis_id} onClick={onClose} /> : run.acceptance ? t('costs.runs.acceptance') : '—',
          },
          { key: 'step', label: t('costs.run.step'), value: stepText(run, t) || '—' },
          { key: 'what', label: t('costs.run.what'), value: isKnownKind(run.kind) ? t(`costs.run.whatKinds.${run.kind}`) : '—' },
          { key: 'effort', label: t('costs.run.effort'), value: run.effort ? t('costs.run.effortValue', { effort: run.effort, word: effort }) : '—' },
          { key: 'version', label: t('costs.run.version'), value: <span className="mono">{run.prompt_version ?? '—'}</span> },
          { key: 'tokens', label: t('costs.run.thinking'), value: run.thinking_tokens !== null ? formatNumber(run.thinking_tokens) : '—' },
          { key: 'model', label: t('costs.run.modelId'), value: <span className="mono">{run.model}</span> },
        ]}
      />
      <Howto>{price ? t('costs.run.howto', { date: formatDateTime(price.valid_from, { calendar: false }) }) : t('costs.run.howtoNoPrice')}</Howto>
    </Modal>
  );
}

interface RunsCardProps {
  usage: AiUsage;
  budget: AiBudget;
  admin: boolean;
  mobile: boolean;
  filter: Filter;
  onFilter: (filter: Filter) => void;
}

export function RunsCard({ usage, budget, admin, mobile, filter, onFilter }: RunsCardProps) {
  const { t } = useTranslation();
  const runs = useAiRuns(filter === 'all' ? null : filter);
  const [open, setOpen] = useState<AiRun | null>(null);
  const items = runs.data?.pages.flatMap((page) => page.items) ?? [];
  const first = runs.data?.pages[0];
  const kinds = usage.kinds.filter((kind) => kind.runs > 0 && isKnownKind(kind.kind)).map((kind) => kind.kind as RunFilter);
  const hasShared = admin && (usage.shared_usd > 0 || usage.acceptance_usd > 0);
  const options: { value: Filter; label: string }[] = [
    { value: 'all', label: t('costs.runs.all') },
    ...kinds.map((kind) => ({ value: kind as Filter, label: mobile ? t(`costs.kindsTiny.${kind as 'analysis'}`) : kindLabel(kind, t) })),
    ...(hasShared ? [{ value: 'shared' as Filter, label: t('costs.runs.acceptance') }] : []),
  ];
  const segmented = <Segmented<Filter> className="costs-runs-filter" label={t('costs.runs.filter')} value={filter} onChange={onFilter} items={options} />;
  const label = filter === 'all' ? t('costs.runs.totalAll') : filter === 'shared' ? t('costs.runs.acceptance') : kindLabel(filter, t);

  let list;
  if (runs.isPending) list = <Skeleton lines={5} />;
  else if (!first) {
    list = (
      <Callout kind="bad" role="alert">
        {t('costs.runs.failed')} {apiErrorText(runs.error)}{' '}
        <Button size="sm" kind="ghost" icon="refresh" onClick={() => void runs.refetch()}>
          {t('common.retry')}
        </Button>
      </Callout>
    );
  } else if (!items.length) list = <EmptyState>{t('costs.runs.empty')}</EmptyState>;
  else if (mobile) {
    list = (
      <ul className="costs-runlist" aria-label={t('costs.runs.caption')}>
        {items.map((run) => (
          <RunItem key={run.id} run={run} onOpen={() => setOpen(run)} />
        ))}
      </ul>
    );
  } else {
    list = (
      <div className="costs-table">
        <DataTable caption={t('costs.runs.caption')} columns={columns(t)} rows={items} rowKey={(run) => run.id} onRowClick={setOpen} />
      </div>
    );
  }

  return (
    <Card
      id="costs-runs"
      className={cx('costs-card costs-runs costs-anchor', runs.isPlaceholderData && 'costs-pending')}
      title={t('costs.runs.title')}
      subtitle={admin ? t('costs.runs.subtitleAdmin') : t('costs.runs.subtitle')}
      actions={mobile ? undefined : segmented}
      flush={!mobile && items.length > 0}
      foot={
        <>
          {first && (
            <span className="small muted">
              {t('costs.runs.foot', { label, calls: t('costs.calls', { count: first.total_runs }), amount: formatUsd(first.total_cost_usd) })}
              {items.length < first.total_runs ? t('costs.runs.shown', { n: items.length }) : ''}
            </span>
          )}
          {runs.hasNextPage && (
            <Button kind="ghost" size="sm" icon="list" className="costs-push" loading={runs.isFetchingNextPage} onClick={() => void runs.fetchNextPage()}>
              {t('costs.runs.loadMore')}
            </Button>
          )}
          <span className="xsmall muted costs-full">{admin ? t('costs.runs.noteAdmin', { amount: usdLimit(budget.budget?.eval_budget_usd ?? 0) }) : budget.mode === 'own' ? t('costs.runs.noteOwn') : t('costs.runs.noteMember')}</span>
        </>
      }
    >
      {mobile && <div className="costs-min">{segmented}</div>}
      {list}
      {open && <RunModal run={open} budget={budget} admin={admin} mobile={mobile} onClose={() => setOpen(null)} />}
    </Card>
  );
}

/** «Цены моделей» (pricesModal макета): из model_prices; модель без цены не запускается. */
export function PricesModal({ usage, onClose, mobile }: { usage: AiUsage; onClose: () => void; mobile: boolean }) {
  const { t } = useTranslation();
  const used = (price: ModelPrice) => {
    const kinds = usage.kinds.filter((kind) => kind.models.includes(price.model)).map((kind) => kindLabel(kind.kind, t));
    const settings = usage.settings;
    const byConfig = [
      settings.parse_model === price.model ? kindLabel('parse', t) : null,
      settings.news_model === price.model ? kindLabel('news', t) : null,
      settings.analysis_model === price.model ? kindLabel('analysis', t) : null,
    ].filter((item): item is string => item !== null);
    const list = [...new Set([...kinds, ...byConfig])];
    return list.length ? list.join(', ') : t('costs.prices.unused');
  };
  const search = usage.prices[0]?.search_price ?? null;
  const longNotes = usage.prices
    .filter((price) => price.long_input_threshold !== null && price.long_multiplier !== null)
    .map((price) => ({
      key: price.model,
      label: modelLabel(price.model),
      value: t('costs.prices.long', { threshold: formatTokens(price.long_input_threshold, { compact: true }), factor: formatNumber(price.long_multiplier ?? 1, 0) }),
    }));
  return (
    <Modal open wide onClose={onClose} title={t('costs.prices.title')} footer={<Button kind="primary" onClick={onClose}>{t('costs.prices.ok')}</Button>}>
      <p className="soft">{mobile ? t('costs.prices.leadMobile') : t('costs.prices.lead')}</p>
      {usage.prices.length ? (
        <DataTable
          mobileLayout="table"
          caption={t('costs.prices.title')}
          rows={usage.prices}
          rowKey={(price) => price.model}
          columns={[
            {
              key: 'model',
              label: t('costs.prices.cols.model'),
              render: (price) => (
                <div className="costs-price-model">
                  <b>{modelLabel(price.model)}</b>
                  <span className="mono">{price.model}</span>
                </div>
              ),
            },
            { key: 'input', label: t('costs.prices.cols.input'), align: 'r', render: (price) => unitPrice(price.input) },
            { key: 'write', label: t('costs.prices.cols.write'), align: 'r', hideMobile: true, render: (price) => unitPrice(price.cache_write_5m) },
            { key: 'read', label: t('costs.prices.cols.read'), align: 'r', hideMobile: true, render: (price) => unitPrice(price.cache_read) },
            { key: 'output', label: t('costs.prices.cols.output'), align: 'r', render: (price) => unitPrice(price.output) },
            { key: 'used', label: t('costs.prices.cols.used'), hideMobile: true, render: (price) => <span className="small soft">{used(price)}</span> },
          ]}
        />
      ) : (
        <EmptyState>{t('costs.prices.empty')}</EmptyState>
      )}
      <KeyValue
        items={[
          ...(search !== null ? [{ key: 'search', label: t('costs.prices.search'), value: t('costs.prices.searchValue', { amount: formatUsd(search * 1000, 0) }) }] : []),
          ...longNotes,
          { key: 'batch', label: t('costs.prices.batch'), value: t('costs.prices.batchValue') },
        ]}
      />
    </Modal>
  );
}

export type { Filter as RunsFilter };
