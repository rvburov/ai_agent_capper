import type { TFunction } from 'i18next';
import { useTranslation } from 'react-i18next';

import { Callout, Card, Chip, Icon, type IconName } from '../../components';
import { plural } from '../../features/learning/display';
import type { LearningSummary } from '../../features/learning/types';
import { formatUsd } from '../../lib/format';

// «Как модель учится» (cycleCard макета): шесть шагов цикла, петля «следующая ставка — с учетом
// урока», что учится, а что нет, и сколько ждать результата.

type StepId = 'bet' | 'result' | 'review' | 'hypothesis' | 'check' | 'prompt';

const STEPS: readonly { id: StepId; icon: IconName; who: IconName }[] = [
  { id: 'bet', icon: 'ticket', who: 'user' },
  { id: 'result', icon: 'database', who: 'bolt' },
  { id: 'review', icon: 'search', who: 'spark' },
  { id: 'hypothesis', icon: 'book', who: 'spark' },
  { id: 'check', icon: 'flask', who: 'bolt' },
  { id: 'prompt', icon: 'brain', who: 'user' },
];

/**
 * Пороги и цены шагов — из сводки сервера (настройки и живые числа): своих случаев для проверки
 * урока, матчей быстрой проверки, цена разбора и быстрой проверки, событий для поправки Claude
 * числом. Сводки нет — тексты без чисел.
 */
function stepText(id: StepId, summary: LearningSummary | null, t: TFunction): string {
  if (!summary) return id === 'check' || id === 'prompt' ? t(`learning.cycle.steps.${id}.textNoMin`) : t(`learning.cycle.steps.${id}.text`);
  const { thresholds, prices } = summary;
  return t(`learning.cycle.steps.${id}.text`, {
    fromCases: plural(t, 'fromCases', thresholds.lesson_min_cases),
    onMatches: plural(t, 'onMatches', thresholds.quick_check_events),
    price: formatUsd(prices.quick_check_usd),
  });
}

function stepWho(id: StepId, summary: LearningSummary | null, t: TFunction): string {
  if (id !== 'review') return t(`learning.cycle.steps.${id}.who`);
  return summary ? t('learning.cycle.steps.review.who', { price: formatUsd(summary.prices.postmortem_usd) }) : t('learning.cycle.steps.review.whoNoPrice');
}

export function CycleCard({ summary }: { summary: LearningSummary | null }) {
  const { t } = useTranslation();
  const claudeMinEvents = summary?.thresholds.claude_min_events ?? null;
  return (
    <Card className="learning-card" title={t('learning.cycle.title')} subtitle={t('learning.cycle.subtitle')}>
      <ol className="learning-cycle" aria-label={t('learning.cycle.label')}>
        {STEPS.map((step, i) => (
          <li key={step.id} className={`learning-step is-${step.id}`}>
            <div className="learning-step-mark">
              <span className="learning-step-num" aria-hidden="true">
                {i + 1}
              </span>
              <Icon name={step.icon} />
            </div>
            <div className="learning-step-body">
              <h4>
                <span className="sr-only">{t('learning.cycle.step', { n: i + 1 })}</span>
                {t(`learning.cycle.steps.${step.id}.title`)}
              </h4>
              <p>{stepText(step.id, summary, t)}</p>
              <Chip kind="outline" icon={step.who}>
                {stepWho(step.id, summary, t)}
              </Chip>
            </div>
            {i < STEPS.length - 1 && (
              <span className="learning-step-arrow" aria-hidden="true">
                <Icon name="arrowRight" />
              </span>
            )}
          </li>
        ))}
      </ol>
      <div className="learning-loop">
        <span className="learning-loop-label">
          <Icon name="refresh" />
          <span>
            <b>{t('learning.cycle.loop')}</b>
            {t('learning.cycle.loopText')}
          </span>
        </span>
      </div>
      <Callout kind="info">
        <b>{t('learning.cycle.calloutStrong')}</b>
        {claudeMinEvents === null ? t('learning.cycle.calloutTextNoMin') : t('learning.cycle.calloutText', { min: claudeMinEvents })}
      </Callout>
      <p className="learning-doc">
        <Icon name="clock" />
        <span>{t('learning.cycle.doc')}</span>
      </p>
    </Card>
  );
}
