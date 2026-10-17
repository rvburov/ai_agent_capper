import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router';

import { paths } from '../../app/paths';
import { Button, Callout, Card, Chip, Icon, KeyValue, Skeleton, type ChipKind, type IconName } from '../../components';
import { useRecentAnalyses, useStrategy } from '../../features/analysis/api';
import { inlineDateTime } from '../../features/analysis/codes';
import { displayName, shortName } from '../../features/analysis/draft';
import { analysisNumber } from '../../features/analysis/number';
import type { AnalysisListItem, AnalysisStatus, StrategyParams } from '../../features/analysis/types';
import { isActive } from '../../features/analysis/types';
import { formatMoney, formatOdds, formatPercent, formatUsd, type Currency } from '../../lib/format';
import { cx } from '../../lib/cx';
import type { LaunchSummary } from './summary';

// Правая колонка «Нового анализа»: что произойдет после запуска, правила стратегии, последние
// анализы (flowCard, rulesCard, recentCard в mockup/js/screens/new-analysis.js).

/** Наибольший итоговый кэф экспресса из 2 событий: «≤ 3.24». */
function totalMax(params: StrategyParams | undefined): string {
  return formatOdds(params?.double_total[1] ?? '3.24');
}

export function FlowCard({
  summary,
  bank,
  currency,
  params,
}: {
  summary: LaunchSummary;
  bank: string | null;
  currency: Currency;
  params: StrategyParams | undefined;
}) {
  const { t } = useTranslation();
  const steps: Array<[IconName, string, string, string]> = [];
  if (summary.stale.length) {
    steps.push(['globe', 'warn', t('new.flow.newsTitle'), t('new.flow.newsText', { names: summary.stale.map((p) => p.short).join(', ') })]);
  } else {
    steps.push(['database', 'accent', t('new.flow.freshTitle'), t('new.flow.freshText')]);
  }
  steps.push(['database', '', t('new.flow.dossierTitle'), t('new.flow.dossierText')]);
  steps.push([
    'brain',
    '',
    t('new.flow.claudeTitle'),
    t('new.flow.claudeText', { shift: Math.round((params?.claude_max_shift ?? 0.1) * 100) }),
  ]);
  steps.push(['target', '', t('new.flow.marketTitle'), t('new.flow.marketText')]);
  steps.push([
    'ticket',
    '',
    t('new.flow.expressTitle'),
    bank
      ? t('new.flow.expressText', { total: totalMax(params), bank: formatMoney(bank, currency) })
      : t('new.flow.expressTextLedger', { total: totalMax(params) }),
  ]);
  steps.push(['check', '', t('new.flow.decisionTitle'), t('new.flow.decisionText')]);
  return (
    <Card title={t('new.flow.title')}>
      <ol className="new-flow">
        {steps.map(([icon, kind, title, text]) => (
          <li key={title}>
            <span className={cx('new-flow-ic', kind)} aria-hidden="true">
              <Icon name={icon} />
            </span>
            <div className="new-flow-body">
              <b>{title}</b>
              <span>{text}</span>
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function RulesCard({ n }: { n: number }) {
  const { t } = useTranslation();
  const strategy = useStrategy();
  const params = strategy.data?.params;
  return (
    <Card
      className="new-rules"
      title={t('new.rules.title')}
      subtitle={strategy.data ? t('new.rules.version', { code: strategy.data.code }) : undefined}
      actions={
        <Button kind="ghost" size="sm" icon="edit" to={paths.profile('bank')} title={t('new.rules.editTitle')}>
          {t('new.rules.edit')}
        </Button>
      }
    >
      {params ? (
        <KeyValue
          items={[
            { key: 'p', label: t('new.rules.minP'), value: `≥ ${formatPercent(params.min_p, { digits: 0 })}` },
            {
              key: 'odds',
              label: t('new.rules.odds'),
              value: `${formatOdds(params.leg_odds[0])}–${formatOdds(params.leg_odds[1])}`,
            },
            { key: 'legs', label: t('new.rules.legs'), value: t('new.rules.legsValue') },
            { key: 'total', label: t('new.rules.total'), value: `≤ ${totalMax(params)}` },
          ]}
        />
      ) : (
        <Skeleton lines={4} />
      )}
      {n > 3 ? (
        <Callout kind="info">{t('new.rules.many')}</Callout>
      ) : n === 1 ? (
        <Callout kind="warn">{t('new.rules.one')}</Callout>
      ) : (
        <p className="xsmall muted">{t('new.rules.note')}</p>
      )}
    </Card>
  );
}

const STATUS: Partial<Record<AnalysisStatus, [string, ChipKind, IconName]>> = {
  done: ['done', 'good', 'check'],
  failed: ['failed', 'bad', 'alert'],
  cancelled: ['cancelled', 'outline', 'x'],
  needs_confirmation: ['draft', 'outline', 'edit'],
  parsing: ['parsing', 'info', 'clock'],
};

function statusOf(item: AnalysisListItem): [string, ChipKind, IconName] {
  if (isActive(item.status)) return ['running', 'info', 'clock'];
  return STATUS[item.status] ?? ['done', 'good', 'check'];
}

/** Матчи анализа, как на остальных карточках: «Синнер — Руне, Джокович — Рублев». */
export function recentMatches(item: AnalysisListItem, t: TFunction): string {
  return item.pairs
    .map((pair) => t('analysis.matchTitle', { p1: shortName(displayName(pair.player1)), p2: shortName(displayName(pair.player2)) }))
    .join(', ');
}

/** Последние анализы: открыть с того места, где ушли (GET /api/analyses). */
export function RecentCard({ limit = 5 }: { limit?: number }) {
  const { t } = useTranslation();
  // Только запущенные (черновики сервер не отдает): открытый черновик и так на этом экране
  const recent = useRecentAnalyses(limit);
  const items = recent.data?.items ?? [];
  return (
    <Card className="new-recent-card" title={t('new.recent.title')} subtitle={t('new.recent.subtitle')}>
      {recent.isPending ? (
        <Skeleton lines={3} />
      ) : items.length ? (
        <ul className="new-recent">
          {items.map((item) => {
            const [key, kind, icon] = statusOf(item);
            const label = t(`new.recent.status.${key}` as 'new.recent.status.done');
            const matches = item.pairs.length ? recentMatches(item, t) : t('new.recent.noMatches');
            const decision =
              item.status === 'done'
                ? item.decision === 'bet'
                  ? t('new.recent.bet')
                  : item.decision === 'skip'
                    ? t('new.recent.skip')
                    : t('new.recent.waiting')
                : null;
            const sub = [`#${analysisNumber(item.id)}`, inlineDateTime(item.created_at), decision, formatUsd(item.cost_usd)]
              .filter(Boolean)
              .join(' · ');
            const to = paths.analysis(item.id);
            return (
              <li key={item.id}>
                <Link to={to} aria-label={t('new.recent.aria', { id: analysisNumber(item.id), matches, status: label.toLowerCase() })}>
                  <span className="new-recent-m">{matches}</span>
                  <span className="new-recent-s">{sub}</span>
                  <Chip kind={kind} icon={icon}>
                    {label}
                  </Chip>
                </Link>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="small muted">{t('new.recent.empty')}</p>
      )}
    </Card>
  );
}
