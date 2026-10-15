import type { TFunction } from 'i18next';
import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, DataTable, Icon, Stat } from '../../components';
import { ChartWithTable, ColumnChart, HBars, Sparkline } from '../../components/charts';
import { modelLabel } from '../../features/ai/models';
import type { AiBudget } from '../../features/ai/types';
import { doneAnalyses, kindLabel, kindsByCost, priciestDay, shareText, usdRun, usdSum } from '../../features/costs/display';
import type { AgentSettings, AiUsage, UsageDay, UsageKind } from '../../features/costs/types';
import { usdLimit } from '../../features/dashboard/display';
import { formatDate, formatNumber, formatPercent, formatTokens, formatUsd, formatWeekday } from '../../lib/format';
import { TERMINAL_CLI } from '../../lib/terminal';
import type { Period } from './Hero';

// Блоки «ИИ и расходов» о собственных вызовах (tiles, dailyCard, typesCard, versionsCard,
// laterCard, settingsCard макета). Все числа — из GET /api/ai/usage.

export function Howto({ children }: { children: ReactNode }) {
  return (
    <div className="costs-howto">
      <Icon name="info" />
      <span>{children}</span>
    </div>
  );
}

function ModelChips({ models, efforts }: { models: readonly string[]; efforts: readonly string[] }) {
  const { t } = useTranslation();
  return (
    <>
      {models.map((model) => (
        <Chip key={model} kind="outline">
          {modelLabel(model)}
        </Chip>
      ))}
      {efforts.map((effort) => (
        <Chip key={effort} kind="outline">
          {t('costs.effortChip', { effort })}
        </Chip>
      ))}
    </>
  );
}

/** Плитки: цена анализа, доля кэша, токены, поиски — со спарклайнами по дням (tiles макета). */
export function Tiles({ usage }: { usage: AiUsage }) {
  const { t } = useTranslation();
  const done = doneAnalyses(usage);
  const totals = usage.totals;
  const spark = (values: number[]) => (values.filter((v) => v > 0).length > 1 ? <Sparkline values={values} color="var(--s1)" /> : undefined);
  const tiles = [
    {
      key: 'price',
      icon: 'spark' as const,
      label: t('costs.tiles.price'),
      value: usage.avg_analysis_usd !== null ? formatUsd(usage.avg_analysis_usd) : '—',
      hint: t('costs.tiles.priceHint', { count: done.length }),
      aside: spark(done.map((analysis) => analysis.cost_usd)),
    },
    {
      key: 'cache',
      icon: 'database' as const,
      label: t('costs.tiles.cache'),
      value: totals.cache_share !== null ? formatPercent(totals.cache_share, { digits: 0 }) : '—',
      hint: t('costs.tiles.cacheHint', { amount: formatUsd(usage.cache_saved_usd) }),
      aside: spark(usage.days.map((day) => day.cache_share ?? 0)),
    },
    {
      key: 'tokens',
      icon: 'layers' as const,
      label: t('costs.tiles.tokens'),
      value: formatTokens(totals.prompt_tokens + totals.output_tokens, { compact: true }),
      hint: t('costs.tiles.tokensHint', { input: formatTokens(totals.prompt_tokens, { compact: true }), output: formatTokens(totals.output_tokens, { compact: true }) }),
      aside: spark(usage.days.map((day) => day.prompt_tokens + day.output_tokens)),
    },
    {
      key: 'searches',
      icon: 'globe' as const,
      label: t('costs.tiles.searches'),
      value: formatNumber(totals.web_searches),
      hint: t('costs.tiles.searchesHint', { amount: formatUsd(usage.search_usd), n: usage.settings.news_searches_per_match }),
      aside: spark(usage.days.map((day) => day.web_searches)),
    },
  ];
  return (
    <div className="grid costs-tiles">
      {tiles.map((tile) => (
        <div key={tile.key} className="col-3 half-mobile costs-kpi">
          <Stat icon={tile.icon} label={tile.label} value={tile.value} hint={tile.hint} aside={tile.aside} />
        </div>
      ))}
    </div>
  );
}

function dayTip(day: UsageDay, t: TFunction) {
  return [
    { key: 'total', name: t('costs.daily.tipTotal'), value: usdRun(day.cost_usd) },
    ...day.kinds
      .filter((kind) => kind.runs > 0)
      .map((kind) => ({
        key: kind.kind,
        name: kind.runs > 1 ? t('costs.daily.tipKindN', { kind: kindLabel(kind.kind, t), n: kind.runs }) : kindLabel(kind.kind, t),
        value: usdRun(kind.cost_usd),
      })),
  ];
}

/** Расход по дням (дни по UTC, как месяц расходов) с темпом под лимит или бюджет и прогнозом. */
export function DailyCard({ usage, budget, admin, period, mobile }: { usage: AiUsage; budget: AiBudget; admin: boolean; period: Period; mobile: boolean }) {
  const { t } = useTranslation();
  // Темп под лимит или бюджет (лимит на дни месяца) и средние в день — с сервера
  const pace = usage.pace_usd;
  const max = priciestDay(usage.days);
  const over = pace !== null ? usage.days.filter((day) => day.cost_usd > pace).length : 0;
  let paceText = '';
  if (admin && budget.budget && usage.days_elapsed > 0 && pace !== null) {
    paceText = t('costs.daily.paceAdmin', {
      all: formatUsd(budget.budget.per_day_usd),
      pace: formatUsd(pace),
      mine: formatUsd(budget.per_day_usd),
    });
  } else if (pace !== null) {
    paceText = over ? t('costs.daily.over', { count: over }) : t('costs.daily.noOver');
  }
  const maxText = max
    ? t('costs.daily.max', {
        day: formatDate(max.day),
        amount: formatUsd(max.cost_usd),
        kinds: max.kinds
          .filter((kind) => kind.runs > 0)
          .map((kind) => `${kindLabel(kind.kind, t).toLowerCase()}${kind.runs > 1 ? ` ×${kind.runs}` : ''}`)
          .join(', '),
      })
    : '';
  const items = usage.days.map((day) => ({
    key: day.day,
    label: `${formatDate(day.day)}, ${formatWeekday(day.day)}`,
    short: formatDate(day.day),
    value: day.cost_usd,
    tip: dayTip(day, t),
  }));
  return (
    <Card
      className="costs-card costs-o-1"
      title={t('costs.daily.title')}
      subtitle={`${t('costs.daily.subtitle', { period: period.long })}${admin ? '' : t('costs.daily.mine')}`}
      actions={pace !== null ? <Chip kind="outline">{t(admin ? 'costs.daily.paceBudget' : 'costs.daily.paceLimit', { amount: formatUsd(pace) })}</Chip> : undefined}
    >
      <ChartWithTable
        empty={usage.totals.runs === 0 ? t('costs.daily.empty') : undefined}
        table={() => (
          <DataTable
            mobileLayout="table"
            className="costs-tablebox"
            caption={t('costs.daily.title')}
            rows={usage.days}
            rowKey={(day) => day.day}
            columns={[
              { key: 'day', label: t('costs.daily.cols.day'), render: (day) => `${formatDate(day.day)}, ${formatWeekday(day.day)}` },
              { key: 'runs', label: t('costs.daily.cols.runs'), align: 'r', render: (day) => formatNumber(day.runs) },
              { key: 'tokens', label: t('costs.daily.cols.tokens'), align: 'r', render: (day) => formatTokens(day.prompt_tokens + day.output_tokens, { compact: true }) },
              { key: 'cost', label: t('costs.daily.cols.cost'), align: 'r', render: (day) => <b>{usdRun(day.cost_usd)}</b> },
            ]}
          />
        )}
      >
        <ColumnChart
          items={items}
          height={mobile ? 180 : 210}
          valueFormat={(value) => formatUsd(value)}
          seriesName={t('costs.daily.series')}
          highlightLast={usage.current}
          ariaLabel={t('costs.daily.aria', { period: period.long })}
        />
      </ChartWithTable>
      {/* вызовов не было — графика нет, и «как читать» его, темп и прогноз не нужны */}
      {usage.totals.runs > 0 && (
        <Howto>
          {t('costs.daily.howto')}
          {maxText && ` ${maxText}`}
          {paceText && ` ${paceText}`}
          {usage.current && ` ${t('costs.daily.forecast', { end: period.end, amount: formatUsd(usage.forecast_usd) })}`}
        </Howto>
      )}
    </Card>
  );
}

function perText(kind: string, settings: AgentSettings, t: TFunction): string {
  if (kind === 'analysis') return t('costs.types.perAnalysis');
  if (kind === 'news') return t('costs.types.perNews', { count: settings.news_searches_per_match });
  if (kind === 'parse') return t('costs.types.perParse');
  return '';
}

function kindMeta(kind: UsageKind, settings: AgentSettings, t: TFunction): string {
  const parts = [t('costs.calls', { count: kind.runs })];
  const per = perText(kind.kind, settings, t);
  if (per) parts.push(per);
  if (kind.avg_prompt_tokens !== null && kind.avg_output_tokens !== null) {
    parts.push(t('costs.types.avgTokens', { input: formatTokens(kind.avg_prompt_tokens, { compact: true }), output: formatTokens(kind.avg_output_tokens, { compact: true }) }));
  }
  if (kind.cache_read_tokens > 0 && kind.cache_share !== null) parts.push(t('costs.types.cached', { pct: formatPercent(kind.cache_share, { digits: 0 }) }));
  else parts.push(kind.cache_write_tokens > 0 ? t('costs.types.writes') : t('costs.types.noCache'));
  if (kind.web_searches > 0) parts.push(t('costs.searches', { count: kind.web_searches }));
  return parts.join(' · ');
}

/** «На что уходят деньги»: виды вызовов полосами и списком с моделью и effort; нажатие — журнал. */
export function TypesCard({ usage, period, onPick }: { usage: AiUsage; period: Period; onPick: (kind: string) => void }) {
  const { t } = useTranslation();
  const kinds = kindsByCost(usage);
  return (
    <Card className="costs-card costs-o-2" title={t('costs.types.title')} subtitle={t('costs.types.subtitle', { period: period.long })}>
      {kinds.length ? (
        <>
          <HBars
            ariaLabel={t('costs.types.aria')}
            valueFormat={(value) => usdSum(value, t)}
            items={kinds.map((kind) => ({ key: kind.kind, label: kindLabel(kind.kind, t), value: kind.cost_usd, note: shareText(kind.share, t), dot: false }))}
          />
          <ul className="costs-types" aria-label={t('costs.types.listLabel')}>
            {kinds.map((kind) => (
              <li key={kind.kind}>
                <button type="button" className="costs-type" title={t('costs.types.show', { kind: kindLabel(kind.kind, t) })} onClick={() => onPick(kind.kind)}>
                  <span className="costs-type-name">
                    {kindLabel(kind.kind, t)}
                    <ModelChips models={kind.models} efforts={kind.efforts} />
                  </span>
                  <span className="costs-type-meta">{kindMeta(kind, usage.settings, t)}</span>
                  <span className="costs-type-cost">
                    <span>
                      <b>{kind.avg_cost_usd !== null ? usdRun(kind.avg_cost_usd) : '—'}</b>
                      <small>{kind.kind === 'parse' ? t('costs.types.perInput') : kind.kind === 'news' || kind.kind === 'analysis' ? t('costs.types.perMatch') : t('costs.types.perCall')}</small>
                    </span>
                    <Icon name="chevronRight" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Howto>{t('costs.types.howto', { period: period.short, hours: usage.settings.news_ttl_hours })}</Howto>
        </>
      ) : (
        <p className="small muted">{t('costs.types.empty')}</p>
      )}
    </Card>
  );
}

/** «Версии инструкций: цена и качество» (В12): цена по версии — сейчас, качество — этап 5. */
export function VersionsCard({ usage, period }: { usage: AiUsage; period: Period }) {
  const { t } = useTranslation();
  const rows = usage.versions.filter((version) => version.runs > 0);
  return (
    <Card className="costs-card costs-o-4" title={t('costs.versions.title')} subtitle={t('costs.versions.subtitle', { period: period.short })}>
      {rows.length ? (
        <DataTable
          className="costs-ver"
          caption={t('costs.versions.title')}
          rows={rows}
          rowKey={(row) => `${row.kind}:${row.prompt_version ?? ''}`}
          columns={[
            { key: 'version', label: t('costs.versions.cols.version'), primary: true, render: (row) => <span className="mono">{row.prompt_version ?? '—'}</span> },
            { key: 'kind', label: t('costs.versions.cols.kind'), render: (row) => kindLabel(row.kind, t) },
            { key: 'runs', label: t('costs.versions.cols.runs'), align: 'r', render: (row) => formatNumber(row.runs) },
            { key: 'cost', label: t('costs.versions.cols.cost'), align: 'r', render: (row) => <b>{row.avg_cost_usd !== null ? usdRun(row.avg_cost_usd) : '—'}</b> },
            { key: 'quality', label: t('costs.versions.cols.quality'), align: 'r', render: () => <span className="muted">{t('costs.versions.stage5')}</span> },
          ]}
        />
      ) : (
        <p className="small muted">{t('costs.versions.empty')}</p>
      )}
      <Howto>
        {t('costs.versions.howto')}
        {usage.avg_analysis_usd !== null && ` ${t('costs.versions.avg', { amount: formatUsd(usage.avg_analysis_usd) })}`}
      </Howto>
    </Card>
  );
}

/** «Появится на этапе 5» (В12): «Где экономим», «До и после», смена модели из интерфейса. */
export function LaterCard() {
  const { t } = useTranslation();
  const items: { key: 'savings' | 'before' | 'switch'; icon: 'flask' | 'history' | 'sliders' }[] = [
    { key: 'savings', icon: 'flask' },
    { key: 'before', icon: 'history' },
    { key: 'switch', icon: 'sliders' },
  ];
  return (
    <Card className="costs-card costs-o-3" title={t('costs.later.title')} subtitle={t('costs.later.subtitle')}>
      <ul className="costs-later">
        {items.map((item) => (
          <li key={item.key}>
            <span className="costs-later-ic">
              <Icon name={item.icon} />
            </span>
            <span>
              <b>{t(`costs.later.${item.key}.title`)}</b> {t(`costs.later.${item.key}.text`)}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

interface ListItem {
  key: string;
  title: ReactNode;
  sub?: ReactNode;
  value?: ReactNode;
}

function MList({ items }: { items: readonly ListItem[] }) {
  return (
    <ul className="costs-mlist">
      {items.map((item) => (
        <li key={item.key}>
          <span className="t">{item.title}</span>
          {item.sub !== undefined && <span className="s">{item.sub}</span>}
          {item.value !== undefined && <span className="v">{item.value}</span>}
        </li>
      ))}
    </ul>
  );
}

/** «Как настроено» — только показ (В12, Р23): меняет команда agent-config на сервере. */
export function SettingsCard({ usage, budget, admin }: { usage: AiUsage; budget: AiBudget; admin: boolean }) {
  const { t } = useTranslation();
  const s = usage.settings;
  const avg = (kind: string) => {
    const found = usage.kinds.find((item) => item.kind === kind);
    return found?.avg_cost_usd != null ? t('costs.settings.perCall', { amount: usdRun(found.avg_cost_usd) }) : '';
  };
  const own = budget.mode === 'own';
  const on = (
    <Chip kind="good" icon="check">
      {t('costs.settings.on')}
    </Chip>
  );
  const off = <Chip kind="outline">{t('costs.settings.off')}</Chip>;
  const steps: ListItem[] = [
    { key: 'parse', title: kindLabel('parse', t), sub: `${t('costs.settings.parse', { model: modelLabel(s.parse_model), effort: s.parse_effort })}${avg('parse')}` },
    {
      key: 'news',
      title: kindLabel('news', t),
      sub: s.news_enabled ? `${t('costs.settings.news', { model: modelLabel(s.news_model), effort: s.news_effort, n: s.news_searches_per_match })}${avg('news')}` : t('costs.settings.newsOff'),
    },
    { key: 'analysis', title: kindLabel('analysis', t), sub: `${t('costs.settings.analysis', { model: modelLabel(s.analysis_model), effort: s.analysis_effort, n: s.analysis_parallel })}${avg('analysis')}` },
  ];
  const limits: ListItem[] = [
    { key: 'searches', title: t('costs.settings.searches'), sub: t('costs.settings.searchesSub'), value: `${s.news_searches_per_match} / ${s.news_searches_per_analysis} / ${s.news_searches_per_day}` },
    { key: 'lookback', title: t('costs.settings.lookback'), value: t('costs.settings.days', { count: s.news_lookback_days }) },
    { key: 'reuse', title: t('costs.settings.reuse'), sub: t('costs.settings.reuseSub'), value: t('costs.settings.hours', { count: s.assessment_reuse_hours }) },
  ];
  if (own) limits.push({ key: 'cap', title: t('costs.settings.ownCap'), sub: t('costs.settings.ownCapSub'), value: usdLimit(budget.own_cap_usd) });
  else if (!admin && budget.monthly_usd !== null) {
    limits.push({
      key: 'limit',
      title: t('costs.settings.limit'),
      sub: t('costs.settings.limitSub'),
      value: `${usdLimit(budget.monthly_usd)} · ${budget.daily_analyses ?? '—'} · ${usdLimit(budget.per_analysis_usd)}`,
    });
  } else if (admin) {
    limits.push({ key: 'soft', title: t('costs.settings.soft'), sub: t('costs.settings.softSub', { hard: usdLimit(s.hard_cap_usd) }), value: t('costs.settings.from', { amount: formatUsd(s.soft_cap_usd) }) });
  }
  const tricks: ListItem[] = [
    { key: 'cache', title: t('costs.settings.promptCache'), sub: t('costs.settings.promptCacheSub'), value: on },
    { key: 'newsCache', title: t('costs.settings.newsCache', { hours: s.news_ttl_hours }), sub: t('costs.settings.newsCacheSub', { hours: s.news_ttl_hours }), value: s.news_enabled ? on : off },
    { key: 'newsPrompt', title: t('costs.settings.newsPrompt'), sub: t('costs.settings.newsPromptSub'), value: s.news_prompt_cache ? on : off },
    { key: 'dossier', title: t('costs.settings.dossier'), sub: t('costs.settings.dossierSub'), value: on },
    { key: 'json', title: t('costs.settings.json'), sub: t('costs.settings.jsonSub'), value: on },
  ];
  return (
    <Card id="costs-settings" className="costs-card costs-anchor" title={t('costs.settings.title')} subtitle={t('costs.settings.subtitle', { model: modelLabel(s.analysis_model) })}>
      <div className="costs-settings-grid">
        <div className="costs-settings-col">
          <div className="eyebrow">{t('costs.settings.steps')}</div>
          <MList items={steps} />
          <div className="eyebrow">{t('costs.settings.limits')}</div>
          <MList items={limits} />
        </div>
        <div className="costs-settings-col">
          <div className="eyebrow">{t('costs.settings.tricks')}</div>
          <MList items={tricks} />
          {s.news_domains.length > 0 && <Howto>{t('costs.settings.domains', { list: s.news_domains.join(', ') })}</Howto>}
        </div>
      </div>
      <Callout kind="info" icon="lock">
        {admin ? (
          <>
            {t('costs.settings.adminNote')}
            <code className="mono">{`${TERMINAL_CLI} agent-config`}</code>
            {t('costs.settings.adminNoteTail')}
          </>
        ) : own ? (
          t('costs.settings.ownNote')
        ) : (
          t('costs.settings.memberNote')
        )}
      </Callout>
    </Card>
  );
}
