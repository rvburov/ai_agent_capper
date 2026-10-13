import { useTranslation } from 'react-i18next';

import { paths } from '../../app/paths';
import { Button, Card, Chip, EmptyState, Icon } from '../../components';
import { countText, filterLabel, INSIGHT_ICON, insightTexts } from '../../features/analytics/insights';
import type { Analytics, Insight, InsightFilter } from '../../features/analytics/types';
import { formatDate } from '../../lib/format';
import { cx } from '../../lib/cx';

// «Выводы» (insightsCard макета): до трех выводов, которые считает сервер без запроса к ИИ, с
// основанием и действием — к калибровке, к ставкам, фильтр среза, шире период, снять фильтры,
// «Brier и CLV простыми словами».

export interface InsightActions {
  onCalibration: () => void;
  onFilter: (filter: InsightFilter, label: string) => void;
  onWiden: () => void;
  onClear: () => void;
  onExplain: () => void;
}

function Action({ insight, actions }: { insight: Insight; actions: InsightActions }) {
  const { t } = useTranslation();
  switch (insight.action) {
    case 'calibration':
      return (
        <Button size="sm" icon="target" onClick={actions.onCalibration}>
          {t('analytics.insights.actions.calibration')}
        </Button>
      );
    case 'bets':
      return (
        <Button size="sm" iconRight="chevronRight" to={paths.bets}>
          {t('analytics.insights.actions.bets')}
        </Button>
      );
    case 'filter': {
      const label = filterLabel(t, insight.filter);
      if (!insight.filter || !label) return null;
      const filter = insight.filter;
      return (
        <Button size="sm" icon="filter" onClick={() => actions.onFilter(filter, label)}>
          {t('analytics.insights.actions.filter', { label })}
        </Button>
      );
    }
    case 'widen':
      return (
        <Button size="sm" icon="calendar" onClick={actions.onWiden}>
          {t('analytics.insights.actions.widen')}
        </Button>
      );
    case 'clear':
      return (
        <Button size="sm" icon="refresh" onClick={actions.onClear}>
          {t('analytics.insights.actions.clear')}
        </Button>
      );
    case 'explain':
      return (
        <Button size="sm" icon="book" onClick={actions.onExplain}>
          {t('analytics.insights.actions.explain')}
        </Button>
      );
    default:
      return null;
  }
}

export function Insights({ data, ctx, actions }: { data: Analytics; ctx: string; actions: InsightActions }) {
  const { t } = useTranslation();
  const list = data.insights;
  const updated = data.sample.last_settled_at;
  return (
    <Card
      className="analytics-card analytics-ins-card"
      title={t('analytics.insights.title')}
      subtitle={t('analytics.insights.subtitle', { ctx })}
      actions={
        updated ? (
          <Chip kind="outline" icon="clock">
            {t('analytics.insights.updated', { date: formatDate(updated) })}
          </Chip>
        ) : undefined
      }
      foot={<span className="xsmall muted analytics-min">{t('analytics.insights.foot')}</span>}
    >
      {list.length ? (
        <ol className="analytics-ins" aria-label={t('analytics.insights.title')} style={{ ['--ins-n' as string]: String(list.length) }}>
          {list.map((insight) => {
            const { title, text } = insightTexts(t, insight, data.currency);
            return (
              <li key={insight.code}>
                <span className={cx('analytics-ins-ic', insight.tone)} aria-hidden="true">
                  <Icon name={INSIGHT_ICON[insight.code]} />
                </span>
                <div className="analytics-ins-body">
                  <span className="sr-only">{t(`analytics.insights.tone.${insight.tone}`)}: </span>
                  <div className="analytics-ins-title">{title}</div>
                  <div className="analytics-ins-text">{text}</div>
                  <div className="analytics-ins-foot">
                    <Chip kind="outline">{t('analytics.insights.basis', { basis: countText(t, insight.basis_unit, insight.basis) })}</Chip>
                    <Action insight={insight} actions={actions} />
                  </div>
                </div>
              </li>
            );
          })}
        </ol>
      ) : (
        <EmptyState>{t('analytics.insights.empty')}</EmptyState>
      )}
    </Card>
  );
}
